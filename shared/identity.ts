const brandName = "Monitrail";

export const identity = Object.freeze({
  brandName,
  brandOwner: "XypherCore",
  sourceRepository: "https://github.com/XypherCore/monitrail",
  maintainerName: brandName,
  maintainerEmail: "dev@monitrail.invalid",
  monogram: brandName.charAt(0).toLowerCase(),
  footerText: brandName,
  poweredByText: `Powered by ${brandName}`,
  abuseContactEmail(env: Readonly<{ ABUSE_CONTACT_EMAIL?: string }>): string | undefined {
    const address = env.ABUSE_CONTACT_EMAIL;
    if (address && !/\s/u.test(address) && /^[a-z0-9][a-z0-9._+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(address)) {
      return address;
    }
  },
});

export function checkerUserAgent(appUrl: string): string {
  if (/^https?:\/\/[^/?#@]+\/?$/i.test(appUrl) && !/[\s\\]/u.test(appUrl)) {
    try {
      return `${identity.brandName}/1.0 (+${new URL(appUrl).origin}/bot)`;
    } catch {
      // Return a fixed error even when the invalid input contains credentials.
    }
  }
  throw new Error("Invalid application origin.");
}
