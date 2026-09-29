import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

const baseUrl =
  process.env.NEXT_PUBLIC_ENV === "production"
    ? process.env.NEXT_PUBLIC_BASE_URL
    : process.env.NEXT_PUBLIC_DEV_BASE_URL;

if (!baseUrl) {
  throw new Error("Environment variable NEXT_PUBLIC_BASE_URL is not set");
}

// 07-08 deletion release (AUTH-08): the client token mirror is gone — no
// Authorization header is minted from Redux state. Every authenticated
// request carries ONLY the Better Auth session cookie (credentials: "include");
// Better Auth's client is the single source of session identity.

export const baseApi = createApi({
  reducerPath: "baseApi",
  baseQuery: fetchBaseQuery({
    baseUrl,
    credentials: "include",
  }),
  endpoints: () => ({}),
  tagTypes: [],
});

export default baseApi;
