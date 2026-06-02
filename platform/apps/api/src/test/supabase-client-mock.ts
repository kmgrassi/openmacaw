import { vi } from "vitest";

type QueryResult = {
  data: unknown;
  error: unknown;
};

export type SupabaseQueryState = {
  table: string;
  selectColumns: string | undefined;
  insertBody: unknown;
  updateBody: unknown;
  filters: Array<{ method: "eq" | "in" | "or"; column?: string; value: unknown }>;
  orders: Array<{ column: string; options: unknown }>;
  limitValue: number | undefined;
};

export function createSupabaseMock(resolveQuery: (state: SupabaseQueryState) => QueryResult | Promise<QueryResult>) {
  const queries: SupabaseQueryState[] = [];

  function createBuilder(table: string) {
    const state: SupabaseQueryState = {
      table,
      selectColumns: undefined,
      insertBody: undefined,
      updateBody: undefined,
      filters: [],
      orders: [],
      limitValue: undefined,
    };
    queries.push(state);

    const resolve = () => Promise.resolve(resolveQuery(state));
    const builder = {
      select: vi.fn((columns?: string) => {
        state.selectColumns = columns;
        return builder;
      }),
      insert: vi.fn((body: unknown) => {
        state.insertBody = body;
        return builder;
      }),
      update: vi.fn((body: unknown) => {
        state.updateBody = body;
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        state.filters.push({ method: "eq", column, value });
        return builder;
      }),
      in: vi.fn((column: string, value: unknown[]) => {
        state.filters.push({ method: "in", column, value });
        return builder;
      }),
      or: vi.fn((value: string) => {
        state.filters.push({ method: "or", value });
        return builder;
      }),
      order: vi.fn((column: string, options: unknown) => {
        state.orders.push({ column, options });
        return builder;
      }),
      limit: vi.fn((value: number) => {
        state.limitValue = value;
        return resolve();
      }),
      single: vi.fn(resolve),
      maybeSingle: vi.fn(resolve),
    };

    return builder;
  }

  return {
    client: {
      from: vi.fn(createBuilder),
    },
    queries,
  };
}
