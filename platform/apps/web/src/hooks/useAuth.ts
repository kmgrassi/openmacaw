import { useState, useEffect, useCallback } from "react";
import { getSupabaseClient } from "../api/supabase";
import { isBrokerSessionInvalid } from "../api/broker";
import { fetchAuthState } from "../api/broker-auth";
import { brokerLogout, establishBrokerSession } from "../api/broker-session";
import { isValidUuid } from "../api/ws-types";

export type AuthStatus =
  | "loading"
  | "unauthenticated"
  | "authenticated"
  | "preparing";

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(null);

  const forceReset = useCallback(() => {
    setResolvedAgentId(null);
    setError(null);
    setStatus("unauthenticated");
  }, []);

  const orchestrate = useCallback(async () => {
    try {
      const auth = await fetchAuthState();
      const agentId = auth.resolvedAgentId;
      if (!auth.readyToPrepare || !agentId || !isValidUuid(agentId)) {
        setError(null);
        setStatus("unauthenticated");
        return;
      }
      setResolvedAgentId(agentId);
      setStatus("authenticated");
    } catch (err) {
      if (isBrokerSessionInvalid(err)) {
        forceReset();
        return;
      }
      setError((err as Error).message);
      setStatus("unauthenticated");
    }
  }, [forceReset]);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    await supabase.auth.signOut();
    await brokerLogout();
    forceReset();
  }, [forceReset]);

  useEffect(() => {
    const supabase = getSupabaseClient();

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (
          (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") &&
          session?.access_token
        ) {
          try {
            await establishBrokerSession(session.access_token);
          } catch (err) {
            if (isBrokerSessionInvalid(err)) {
              await signOut();
              return;
            }
            console.warn(
              "[useAuth] broker session sync failed:",
              (err as Error).message,
            );
          }
        }
        if (event === "SIGNED_OUT") {
          forceReset();
        }
      },
    );

    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session?.access_token) {
          setStatus("unauthenticated");
          return;
        }
        await establishBrokerSession(data.session.access_token);
        setStatus("preparing");
        await orchestrate();
      } catch (err) {
        setError((err as Error).message);
        setStatus("unauthenticated");
      }
    })();

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [forceReset, orchestrate, signOut]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setStatus("loading");
      try {
        const supabase = getSupabaseClient();
        const { data, error: authError } =
          await supabase.auth.signInWithPassword({ email, password });
        if (authError || !data.session?.access_token) {
          throw authError || new Error("No session token");
        }
        await establishBrokerSession(data.session.access_token);
        setStatus("preparing");
        await orchestrate();
      } catch (err) {
        setError((err as Error).message);
        setStatus("unauthenticated");
      }
    },
    [orchestrate],
  );

  const signUp = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const supabase = getSupabaseClient();
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
      });
      if (authError) throw authError;
      setError("Sign-up complete. Check your email for verification.");
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return { status, error, resolvedAgentId, signIn, signUp, signOut };
}
