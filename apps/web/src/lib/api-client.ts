import { z } from 'zod';
import { ErrorResponseSchema } from '@carrier/contracts/calls';

export async function readApiResponse<S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> {
  const value: unknown = await response.json();
  const failure = ErrorResponseSchema.safeParse(value);
  if (failure.success) throw new Error(failure.data.error);
  if (!response.ok) throw new Error('API_UNAVAILABLE');
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('API_INVALID_RESPONSE');
  return parsed.data;
}
export async function requestApi<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestInit = {},
): Promise<z.output<S>> {
  const response = await fetch(path, { cache: 'no-store', ...options });
  return readApiResponse(response, schema);
}
