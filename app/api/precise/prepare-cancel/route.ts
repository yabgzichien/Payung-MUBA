import { ethers } from 'ethers';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const MODULE_ABI = ['function cancel()'];

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    const body = await req.json();
    if (typeof body.safe !== 'string' || !ethers.isAddress(body.safe)) {
      throw new ClientError('safe must be a valid address');
    }
    const iface = new ethers.Interface(MODULE_ABI);
    const data = iface.encodeFunctionData('cancel', []);
    return jsonResponse(200, { to: MODULE_ADDRESS, data });
  });
}
