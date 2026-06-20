# Scraper Architecture

This project is being migrated from a single IEHP scraper into a multi-portal scraping platform.

The first migration rule is compatibility: existing IEHP behavior, API payloads, SSE event names, and Excel output should keep working while code moves behind stable contracts.

## Target Flow

Frontend -> Next.js API route -> job store -> scraper registry -> selected portal scraper -> logs/results/downloads -> frontend status/output.

## Boundaries

- `app/` keeps Next.js route and page entrypoints.
- `backend/src/` owns backend contracts, job execution, portal scrapers, browser utilities, and claim-domain parsing.
- `frontend/src/` will hold reusable UI/API pieces as the IEHP page is split.
- `data/` is reserved for local job outputs, logs, downloads, and screenshots.

## Current Phase

Phase 1 creates backend contracts and moves pure claim helpers behind compatibility re-exports. The live IEHP Playwright workflow still runs through the existing API route until it can be split safely.
