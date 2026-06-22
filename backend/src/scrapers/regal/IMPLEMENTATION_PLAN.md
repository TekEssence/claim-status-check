# Regal Portal Implementation Plan

## Current Scope

This portal is in the login and Regal Express Access launch milestone only.

Implemented now:

- Load credentials from env using `env_path_regal`.
- Fallback login Excel support for later deployment/testing.
- Open the Regal login URL.
- Fill username.
- Click `Next`.
- Fill password.
- Click `Verify`.
- Confirm Okta dashboard by checking both `Dashboard` heading and `Sign out` link.
- Find and click the `Regal Express Access (REA)` app card.
- Handle Google Authenticator MFA after REA:
  - if the code page appears directly, submit current TOTP.
  - if the security method selection page appears, choose Google Authenticator, then submit current TOTP.
  - if the direct code page has `Verify with something else`, it can switch to the method selection page.
- Emit screenshot/HTML diagnostics after dashboard confirmation and after REA launch.
- Download a replaced-on-each-run `regal-latest.log` file for local testing.

Not implemented yet:

- VPN-only Regal app page handling after MFA/REA launch.
- Scraping claim data.
- Input/output workbook processing.

## Environment

The loader supports:

```text
.env
.env.local
external env file from env_path_regal / ENV_PATH_REGAL / REGAL_PORTAL_ENV_PATH
```

Expected keys:

```text
REGAL_PORTAL_LOGIN_URL=
REGAL_PORTAL_USERNAME=
REGAL_PORTAL_PASSWORD=
REGAL_TOTP_DATA_VALUE=
REGAL_TOTP_SECRET=
REGAL_TOTP_DIGITS=6
REGAL_TOTP_ALGORITHM=sha1
```

`REGAL_TOTP_DATA_VALUE` is the Google Authenticator migration `data=` value used by the notebook. `REGAL_TOTP_SECRET` is an optional base32-secret fallback.

Local browser mode defaults to headed. Vercel is forced headless.

Shared local automation flags:

```text
BROWSER_HEADLESS=false
BROWSER_KEEP_OPEN=false
```

Use `BROWSER_KEEP_OPEN=true` during local debugging when the browser should remain open after the job ends.

## Login Selectors

Username page:

```text
input[name='identifier'][autocomplete='username']
input[type='submit'][value='Next']
```

Password page:

```text
input[name='credentials.passcode'][type='password']
input[type='submit'][value='Verify']
```

Okta dashboard confirmation:

```text
h2:has-text('Dashboard')
h2:has-text('My Apps')
a[data-se='topbar--sign-out'][href='/login/signout']
```

The sign out link can be attached but hidden in the Okta dashboard. Dashboard confirmation accepts an attached Sign out link plus a visible Dashboard/My Apps heading.

Regal Express Access card:

```text
a[data-se='app-card'][aria-label='launch app Regal Express Access (REA)']
a[data-se='app-card']:has-text('Regal Express Access')
a:has-text('Regal Express Access')
```

MFA:

```text
a[data-se='switchAuthenticator']
[data-se='google_otp'] a[data-se='button'], a[aria-label='Select Google Authenticator.']
input[name='credentials.passcode'][type='text']
input[type='submit'][value='Verify']
```

## Next Step

Run locally with headed browser and `BROWSER_KEEP_OPEN=true`, then inspect/share the page after Google Authenticator verification. The next implementation phase should handle the VPN/app page and then the claim workflow.
