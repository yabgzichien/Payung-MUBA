import { Web3Function, Web3FunctionContext } from '@gelatonetwork/web3-functions-sdk';
import { ethers } from 'ethers';

const MODULE_ABI = [
  'event CommitmentOpened(address indexed safe, uint256 quantity1e6, uint256 targetStrike, uint256 deadline)',
  'function executeRoll(address safe, bytes calldata fillOrderCalldata, uint256 usdcAmount, uint256 orderStrike, uint256 orderExpiry)',
];

type NextRollResponse =
  | { due: false }
  | { due: true; safe: string; fillOrderCalldata: string; usdcAmount: number; orderStrike: number; orderExpiry: number };

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { userArgs, multiChainProvider } = context;
  const moduleAddress = userArgs.moduleAddress as string;
  const apiBaseUrl = userArgs.apiBaseUrl as string; // Payung's deployed origin — set at registration time (Step 3)
  const provider = multiChainProvider.default();
  const module = new ethers.Contract(moduleAddress, MODULE_ABI, provider as any);

  const openedEvents = await module.queryFilter(module.filters.CommitmentOpened(), -50_000);
  const safes = [...new Set(openedEvents.map((e: any) => e.args.safe as string))];

  const iface = new ethers.Interface(MODULE_ABI);
  for (const safe of safes) {
    const res = await fetch(`${apiBaseUrl}/api/precise/next-roll?safe=${safe}`);
    if (!res.ok) continue;
    const data = (await res.json()) as NextRollResponse;
    if (!data.due) continue;

    const callData = iface.encodeFunctionData('executeRoll', [
      data.safe, data.fillOrderCalldata, data.usdcAmount, data.orderStrike, data.orderExpiry,
    ]);
    return { canExec: true, callData: [{ to: moduleAddress, data: callData }] };
  }

  return { canExec: false, message: 'no commitment due to roll' };
});
