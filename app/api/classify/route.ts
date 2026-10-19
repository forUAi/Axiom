import { handleModelRequest } from '../../../server/openai.mjs';
export function POST(request: Request) { return handleModelRequest(request, 'classify'); }
