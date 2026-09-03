import 'dotenv/config';
import { AutomateSDK } from '@gelatonetwork/automate-sdk';
import { ethers } from 'ethers';

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  const automate = new (AutomateSDK as any)(8453, wallet as any);

  const { taskId, tx } = await automate.createTask({
    name: 'Payung Precise Protection Keeper',
    execAddress: process.env.PAYUNG_ROLL_MODULE_ADDRESS!,
    execSelector: '0x00000000', // replaced by the Web3 Function's own dynamic call target at runtime
    dedicatedMsgSender: true,
    web3FunctionArgs: {
      moduleAddress: process.env.PAYUNG_ROLL_MODULE_ADDRESS!,
      apiBaseUrl: process.env.PAYUNG_API_BASE_URL!, // e.g. https://payung.example.com — the deployed Next.js app
    },
  });
  await tx.wait();
  console.log('Gelato task registered:', taskId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
