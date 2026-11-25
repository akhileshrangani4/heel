import { describe, it } from "vitest";
import { shellBrowser } from "./shell-browser.ts";

/**
 * Sign-in in a real browser: a wrong passkey burns the page's challenge, and
 * the same button works again without a reload (an installed app has no
 * reload button). A browser without WebAuthn hears so in words.
 */

const shell = shellBrowser();

describe("sign-in in a browser", () => {
  it("signs in after a wrong passkey without a reload", async () => {
    const { page } = await shell.signedIn();
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(/\/sign-in/);

    // The first answer is spoiled on its way to heel, as a wrong passkey would be.
    let spoiled = false;
    await page.route("**/sign-in", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || spoiled) return route.continue();
      spoiled = true;
      const body = JSON.parse(request.postData() ?? "{}");
      body.response.response.signature = "AAAA";
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByText("That passkey didn't sign you in.").waitFor();
    // The same button works again on the same page.
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  });

  it("says when a browser has no passkeys", async () => {
    const { publicUrl } = await shell.signedIn();
    const bare = await shell.browser().newPage();
    await bare.addInitScript({
      content: 'Object.defineProperty(navigator, "credentials", { value: undefined });',
    });
    await bare.goto(`${publicUrl.origin}/sign-in`);
    await bare.getByRole("button", { name: "Sign in with a passkey" }).click();
    await bare.getByText("This browser can't use passkeys.").waitFor();
    await bare.close();
  });
});
