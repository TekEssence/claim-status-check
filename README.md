## Claim Status Check

This Next.js app uploads:
- A login Excel file (username/password/login URL)
- A claim details Excel file

When you click **Start processing**, the app:
- Logs into IEHP via Playwright (Chrome channel)
- Navigates to the claim status page
- Searches each claim by Member Policy ID and DOS (+/- 1 day)
- Writes these columns into the output sheet:
  - `BotClaimDetails`
  - `BotClaimStatusCheck`
  - `BotClaimStatusCheckTime`
  - `BotClaimStatusCheckError`
- Downloads the updated Excel file

## Getting Started

Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000).

## Excel Input Expectations

### Login Excel
First row should include:
- `username` (or `Username`)
- `password` (or `Password`)
- Optional: `loginUrl` (defaults to `https://providers.iehp.org/account/login`)

### Claim Excel
Each row should include:
- Member policy id column (`Member Policy ID` preferred)
- DOS column (`DOS` preferred, `mm/dd/yyyy`)

## Deployment Notes

Vercel can host the UI/API, but this workflow depends on browser automation and VPN-enabled Chrome access to IEHP. In practice, claim processing is typically run in a local/private environment where Chrome + VPN are available.

## Build

```bash
npm run build
```
