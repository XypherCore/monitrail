"use client";

import { createAuthClient } from "better-auth/react";

// Same-origin client: no server configuration or credentials enter this module.
export const authClient = createAuthClient();
