import { z } from 'zod';
import { InventorySchema, PointSchema } from '@carrier/contracts/operations';
import { SessionError } from '../../errors.js';
import { readNetworkInventory } from '../../integrations/tms/inventory.js';
import type { Inventory, Point } from '@carrier/contracts/operations';
import cities from './data/us-cities.json';
const coordinates = z.record(z.string(), PointSchema).parse(cities);
let cachedInventory: Inventory | undefined;
let pendingInventory: Promise<Inventory> | undefined;
export function cityPoint(city: string, state: string): Point | undefined {
  const key = `${city?.trim().toLowerCase()}|${state}`;
  return coordinates[key];
}
export async function inventory(): Promise<Inventory> {
  if (cachedInventory && Date.now() - Date.parse(cachedInventory.retrieved_at) < 60_000)
    return cachedInventory;
  if (pendingInventory) return pendingInventory;
  const load = async () => {
    const result = await readNetworkInventory();
    if (result.coverage.failed_states.length === result.coverage.states)
      throw new SessionError('TMS_UNAVAILABLE', 503);
    const value = InventorySchema.parse({
      ok: true,
      retrieved_at: new Date().toISOString(),
      coverage: result.coverage,
      records: result.records.map((l) => ({
        ...l,
        origin_point: cityPoint(l.ORIG_CITY, l.ORIG_STATE),
        destination_point: cityPoint(l.DEST_CITY, l.DEST_STATE),
      })),
    });
    // Retry partial scans on the next explicit refresh; never cache them as complete.
    if (result.coverage.complete) cachedInventory = value;
    return value;
  };
  pendingInventory = load();
  try {
    return await pendingInventory;
  } finally {
    pendingInventory = undefined;
  }
}
