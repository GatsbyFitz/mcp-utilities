import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";

// ---------------------------------------------------------------------------
// Single shared credential, gating the upload page only. No user accounts —
// APP_USERNAME/APP_PASSWORD are plain env vars, compared directly since
// there's nothing stored to hash.
// ---------------------------------------------------------------------------

export const authOptions: NextAuthOptions = {
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize(credentials) {
        if (
          credentials?.username === process.env.APP_USERNAME &&
          credentials?.password === process.env.APP_PASSWORD
        ) {
          return { id: "admin", name: credentials!.username };
        }
        return null;
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
};
