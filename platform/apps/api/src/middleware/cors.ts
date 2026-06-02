import type { NextFunction, Request, Response } from "express";

import { errorPayload } from "../http.js";

export function createCorsMiddleware(originsValue: string) {
  const corsAllowedOrigins = new Set(
    originsValue
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  function corsAllowed(origin: string | undefined) {
    if (!origin) return true;
    if (corsAllowedOrigins.has("*")) return true;
    return corsAllowedOrigins.has(origin);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header("origin");
    if (corsAllowed(origin)) {
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Accept, X-Requested-With, Origin, Referer, User-Agent, X-Trace-Id, X-Request-Id",
      );
      res.setHeader("Access-Control-Expose-Headers", "X-Trace-Id, X-Request-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(corsAllowed(origin) ? 204 : 403);
    }

    if (!corsAllowed(origin)) {
      return res.status(403).json(errorPayload("cors_forbidden", "Origin is not allowed"));
    }

    return next();
  };
}
