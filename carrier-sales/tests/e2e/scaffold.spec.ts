import { expect, test } from "@playwright/test";

test("placeholder page loads without application errors or operational data", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Carrier sales", exact: true })).toBeVisible();
  await expect(page.getByText("Business workflows and live integrations are not implemented.", { exact: false })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/MAX_BUY|max_rate/);
  expect(errors).toEqual([]);
});

test("HTTP routes reject unauthenticated callers", async ({ request }) => {
  expect((await request.post("/api/mcp", { data: {} })).status()).toBe(401);
  expect((await request.get("/api/manager/calls")).status()).toBe(401);
});
