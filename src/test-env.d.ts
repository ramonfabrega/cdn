// Types the `env` from "cloudflare:test" as the generated Worker Env (BUCKET, …).
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
