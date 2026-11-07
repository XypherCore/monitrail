export default {
  fetch(request) {
    if (request.method !== "GET") throw new Error("Unexpected fixture method.");
    if (request.url === "https://public.example/redirect")
      return Response.redirect("http://127.0.0.1/");
    if (request.url === "https://public.example/body") return new Response(new Uint8Array(131072));
    const chain = /^https:\/\/public\.example\/chain\/([0-2])$/.exec(request.url);
    if (chain) return Response.redirect(`https://public.example/chain/${Number(chain[1]) + 1}`);
    throw new Error("Unexpected fixture URL.");
  },
};
