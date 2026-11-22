import { activeProfile } from "./profiles";
import { profileSql, type SqlTag } from "./profile-database";
import { resolveDatabaseUrl, DATABASE_URL_HINT } from "./database-url";

/** Each handle captures its request's profile on its first query. */
export function getDb(options: { global?: boolean } = {}): SqlTag {
  if (!resolveDatabaseUrl()) throw new Error(`No Postgres connection string. Set one of: ${DATABASE_URL_HINT}`);
  if (options.global) return profileSql();
  let selected: Promise<SqlTag> | undefined;
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    selected ??= activeProfile().then((profile) => profileSql(profile.id));
    return selected.then((sql) => sql(strings, ...values));
  }) as SqlTag;
  // JSON parameters are driver values and carry no database/profile state.
  tag.json = <T,>(value: T) => profileSql().json(value);
  return tag;
}
