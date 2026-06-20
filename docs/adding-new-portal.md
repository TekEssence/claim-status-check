# Adding A Portal

1. Add a folder under `backend/src/scrapers/<portal-id>`.
2. Add `config.ts` with portal runtime support.
3. Implement `PortalScraper` or extend `BaseScraper`.
4. Register it in `backend/src/scrapers/registry.ts`.
5. Keep portal selectors, auth flow, parsing, and downloads inside the portal folder.
6. Put reusable browser, retry, storage, screenshot, and logging behavior in `backend/src/core`.

Portal code should not know frontend components or Excel UI details.
