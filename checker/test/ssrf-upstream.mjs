export default {
  fetch(request) {
    const url = new URL(request.url);
    if (
      url.origin === "https://cloudflare-dns.com" &&
      url.pathname === "/dns-query" &&
      url.searchParams.get("name") === "public.example" &&
      url.searchParams.get("cd") === "false"
    ) {
      const family = url.searchParams.get("type");
      if (family !== "A" && family !== "AAAA") throw new Error("Unexpected DNS family.");
      const type = family === "A" ? 1 : 28;
      return Response.json(
        {
          Status: 0,
          TC: false,
          RD: true,
          RA: true,
          AD: false,
          CD: false,
          Question: [{ name: "public.example", type }],
          Answer: [
            {
              name: "public.example",
              type,
              TTL: 60,
              data: family === "A" ? "8.8.8.8" : "2606:4700:4700::1111",
            },
          ],
        },
        { headers: { "content-type": "application/dns-json" } },
      );
    }
    if (
      request.method !== "GET" ||
      request.headers.get("User-Agent") !== "Monitrail/1.0 (+https://monitrail.example/bot)"
    ) {
      throw new Error("Unexpected fixture request.");
    }
    if (request.url === "https://public.example/redirect")
      return Response.redirect("http://127.0.0.1/");
    if (request.url === "https://public.example/body") return new Response(new Uint8Array(131072));
    throw new Error("Unexpected fixture URL.");
  },
};
