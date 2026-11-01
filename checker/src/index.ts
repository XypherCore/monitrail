// Phase 0 has no scheduled handler, network calls or monitoring behavior.
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
