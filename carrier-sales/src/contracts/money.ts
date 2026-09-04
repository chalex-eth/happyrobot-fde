import { z } from "zod";

export const moneyCentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).brand<"MoneyCents">();
export type MoneyCents = z.infer<typeof moneyCentsSchema>;
