const SELECTORS = {
  username: "input#txtUserName[name='txtUserName']",
  password: "input#txtPassword[name='txtPassword']",
  loginSubmit: "input#imgbtnPgSubmit[type='button']",
  claimsLink: "a[title='Claims'][href='claimInfo.asp']",
};

async function submitLogin(page) {
  const submit = page.locator(SELECTORS.loginSubmit).first();

  console.log("Waiting for Aerial LOG IN button...");
  await submit.waitFor({ state: "visible", timeout: 30000 });

  await page.waitForFunction((selector) => {
    const button = document.querySelector(selector);
    return button && !button.disabled;
  }, SELECTORS.loginSubmit);

  await submit.scrollIntoViewIfNeeded();

  const attempts = [
    async () => {
      console.log("Submitting Aerial login with Playwright click...");
      await submit.click({ timeout: 10000 });
    },
    async () => {
      console.log("Submitting Aerial login with forced click...");
      await submit.click({ force: true, timeout: 10000 });
    },
    async () => {
      console.log("Submitting Aerial login with password Enter key...");
      await page.locator(SELECTORS.password).press("Enter");
    },
    async () => {
      console.log("Submitting Aerial login with portal ValidateForm fallback...");
      await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        if (!button) {
          throw new Error(`Login button not found for selector: ${selector}`);
        }

        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        });

        if (typeof window.ValidateForm === "function") {
          window.ValidateForm(event);
          return;
        }

        button.dispatchEvent(event);
      }, SELECTORS.loginSubmit);
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      await attempt();
      const submitted = await waitForLoginSubmissionSignal(page);
      if (submitted) {
        console.log("Aerial login submit accepted by portal.");
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Aerial login button did not submit the page.${lastError ? ` Last error: ${lastError.message}` : ""}`
  );
}

async function waitForLoginSubmissionSignal(page) {
  return page.waitForFunction(() => {
    const welcomeVisible = document.body && /WELCOME/i.test(document.body.innerText || "");
    const button = document.querySelector("input#imgbtnPgSubmit");
    const buttonWaiting = button && /please wait/i.test(button.value || "");
    const leftLoginPage = !/LoginDefault\.aspx/i.test(window.location.href);

    return welcomeVisible || buttonWaiting || leftLoginPage;
  }, null, { timeout: 5000 }).then(() => true).catch(() => false);
}

async function loginToAerial(page, config) {
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded" });

  const username = page.locator(SELECTORS.username);
  const password = page.locator(SELECTORS.password);

  await username.waitFor({ state: "visible" });
  await password.waitFor({ state: "visible" });

  await username.fill("");
  await password.fill("");
  await username.fill(config.username);
  await password.fill(config.password);

  const usernameValue = await username.inputValue();
  const passwordValue = await password.inputValue();

  if (usernameValue !== config.username) {
    throw new Error("Login form fill failed: username field does not contain the configured username.");
  }

  if (passwordValue !== config.password) {
    throw new Error("Login form fill failed: password field does not contain the configured password.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    submitLogin(page),
  ]);

  await verifyLoggedIn(page, config);
}

async function verifyLoggedIn(page, config) {
  console.log("Waiting for logged-in WELCOME text...");
  await page.getByText(/WELCOME/i).waitFor({ state: "visible", timeout: 30000 });

  await page.locator(SELECTORS.claimsLink).first().waitFor({ state: "visible", timeout: 30000 });

  if (config.successUrlFragment && !page.url().includes(config.successUrlFragment)) {
    throw new Error(
      `Login verification failed: current URL did not contain ${config.successUrlFragment}. Current URL: ${page.url()}`
    );
  }
}

async function goToClaims(page, config) {
  if (config.claimsUrl) {
    await page.goto(config.claimsUrl, { waitUntil: "domcontentloaded" });
  } else {
    const claimsLink = page.locator(SELECTORS.claimsLink).first();
    await claimsLink.waitFor({ state: "visible", timeout: 30000 });
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      claimsLink.click(),
    ]);
  }

  await verifyClaimsPage(page);
}

async function verifyClaimsPage(page) {
  await page.waitForURL(/claimInfo\.asp/i, { timeout: 30000 }).catch(() => {});

  if (!/claimInfo\.asp/i.test(page.url())) {
    throw new Error(`Claims page verification failed. Current URL: ${page.url()}`);
  }
}

module.exports = {
  SELECTORS,
  loginToAerial,
  goToClaims,
  verifyLoggedIn,
  verifyClaimsPage,
};
