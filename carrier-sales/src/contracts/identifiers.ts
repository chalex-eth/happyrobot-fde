import { z } from "zod";

// Identifier formats other than MC remain provisional until provider contracts are verified.
export const runIdSchema = z.string().trim().min(1).brand<"RunId">();
export const operationIdSchema = z.string().trim().min(1).brand<"OperationId">();
export const loadIdSchema = z.string().trim().min(1).brand<"LoadId">();
export const mcNumberSchema = z.string().regex(/^\d{1,8}$/).brand<"McNumber">();
export const bookingReferenceSchema = z.string().trim().min(1).brand<"BookingReference">();

export type RunId = z.infer<typeof runIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type LoadId = z.infer<typeof loadIdSchema>;
export type McNumber = z.infer<typeof mcNumberSchema>;
export type BookingReference = z.infer<typeof bookingReferenceSchema>;
