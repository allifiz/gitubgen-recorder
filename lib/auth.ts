import { timingSafeEqual } from 'node:crypto';

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hasBearer(request: Request, secret: string) {
  const authorization = request.headers.get('authorization') || '';
  return safeEqual(authorization, `Bearer ${secret}`);
}
