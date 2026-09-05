# Carrier sales

Minimal Next.js starter for the HappyRobot app, using Node 22 and npm.

## Development

```sh
nvm use
npm ci
npm run dev
```

Open http://localhost:3000. No environment variables are required for the starter.

## Checks

```sh
npm run typecheck
npm run build
```

Run the production build locally with `npm start`. GitHub Actions runs typechecking and the build on pull requests and pushes to `main`.

## Import

Use **Next.js**, **Root Directory `.`**, and **Node.js 22.x**. `vercel.json` sets the install and build commands. Keep the default output directory.

HappyRobot imports and updates are manual.

## Structure

- `app/`: application pages and layout.
- `src/`: retained TMS implementation for later integration; currently unused by the app.
- `.github/workflows/`: build checks.
- `vercel.json`: deployment configuration.
