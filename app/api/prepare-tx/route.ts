import { ethers } from 'ethers';
import { quote, collateralDecimals, assertFillable, readClient, USDC_DECIMALS } from '@/src/core';
import { ClientError, getCached, jsonResponse, parseSpend, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const { id, spendUsdc, takerAddress } = await req.json();
    const { candidate } = getCached(String(id));
    const client = readClient();
    const q = await quote(candidate, parseSpend(spendUsdc), client);
    const dec = await collateralDecimals(client, candidate.collateralToken);
    if (dec !== USDC_DECIMALS) {
      throw new ClientError(`${candidate.collateralToken} has ${dec} decimals, not the assumed ${USDC_DECIMALS} — refusing to guess the scale.`);
    }
    const collateralUnits = BigInt(Math.round(q.spendUsdc * 10 ** dec));
    const usdcUnits = BigInt(Math.round(q.spendUsdc * 10 ** USDC_DECIMALS));

    /**
     * What the taker must hold and approve — and it depends entirely on which
     * SIDE the taker is on:
     *
     *   BUYER  (takerIsBuyer): owes the premium and nothing else. Confirmed
     *     on-chain — a buy-side fill needing $0.143529 of `contracts x strike`
     *     reported `needed` of only $0.000483 against a $0.001 premium.
     *   SELLER: must post `contracts x strike` as cash collateral, because a
     *     written put has to guarantee its payout. Short of it, the book
     *     reverts Panic(0x11) on balance or ERC20InsufficientAllowance on
     *     approval, with `needed` matching that product exactly.
     *
     * Charging every fill the seller's number (the previous behaviour) demanded
     * ~100x the premium from buyers and blocked them for no reason.
     */
    const requiredCollateralUnits = candidate.takerIsBuyer
      ? collateralUnits
      : BigInt(Math.ceil(q.contracts * candidate.strike * 10 ** dec));

    assertFillable(candidate, Math.floor(Date.now() / 1000));

    const optionBookAddress = client.getContractAddress('optionBook');
    const fillTx = client.optionBook.encodeFillOrder(candidate.raw, usdcUnits);
    const approveOptionBookTx = client.erc20.encodeApprove(
      candidate.collateralToken,
      optionBookAddress,
      requiredCollateralUnits
    );

    const isAaveToken = candidate.collateralToken.toLowerCase() === '0x4e65fe4dba92790696d040ac24aa414708f5c0ab'.toLowerCase();
    const rawUsdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const aavePoolAddress = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

    let aavePlan = null;
    if (isAaveToken) {
      const aaveIface = new ethers.Interface([
        'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)'
      ]);
      const aaveSupplyData = aaveIface.encodeFunctionData('supply', [
        rawUsdcAddress,
        collateralUnits,
        takerAddress || ethers.ZeroAddress,
        0,
      ]);
      const approveAaveTx = client.erc20.encodeApprove(
        rawUsdcAddress,
        aavePoolAddress,
        collateralUnits
      );
      aavePlan = {
        isAaveToken: true,
        aBasUsdcAddress: candidate.collateralToken,
        rawUsdcAddress,
        aavePoolAddress,
        supplyAmount: collateralUnits.toString(),
        approveAaveTx,
        supplyTx: {
          to: aavePoolAddress,
          data: aaveSupplyData,
        },
      };
    }

    return jsonResponse(200, {
      quote: {
        requestedUsdc: q.requestedUsdc,
        spendUsdc: q.spendUsdc,
        capped: q.capped,
        premiumUsdc: q.premiumUsdc,
        strike: q.strike,
        expiryIso: q.expiry.toISOString(),
        yourSide: q.yourSide,
      },
      collateralToken: candidate.collateralToken,
      collateralDecimals: dec,
      collateralUnits: collateralUnits.toString(),
      /** What the taker must HOLD (not spend) for the fill to not underflow. See above. */
      requiredCollateralUnits: requiredCollateralUnits.toString(),
      contracts: q.contracts,
      optionBookAddress,
      approveOptionBookTx,
      fillTx,
      aavePlan,
    });
  });
}
