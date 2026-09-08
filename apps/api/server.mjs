// Vercel runs the bundle produced by the existing API build. This also avoids
// asking its backend builder to type-check TypeScript 7 with the legacy TS API.
import './dist/server.mjs';
