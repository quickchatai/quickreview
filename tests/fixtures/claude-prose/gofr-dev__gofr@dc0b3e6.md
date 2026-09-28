I reviewed the diff in one careful pass and found 5 problems, all in `/work/repo/gofr-dev__gofr/pkg/gofr/datasource/mongo/mongo.go`:

- **mongo.go:158** — The username and password get escaped twice: once by `url.QueryEscape` and again by `u.String()`. A password like `p@ss` reaches the driver as `p%40ss`, so login fails. A space turns into `+`, which also gives the wrong password.
- **mongo.go:176** — `getDBHost` only accepts the `mongodb` scheme. A `mongodb+srv://` URI, the standard format for MongoDB Atlas, now fails with `errIncorrectURI`, so apps that connected before this change no longer connect.
- **mongo.go:154** — The database name is escaped with `url.PathEscape` and then put into `u.Path`, so `u.String()` escapes it again. For example, `my db` becomes `/my%2520db` in the URI.
- **mongo.go:157** — Credentials are only added when both user and password are set. A config with a user but no password now connects with no user at all, where the old code always included them.
- **mongo.go:98** — The debug log prints `c.config.Host`, which is empty when the config uses a URI, so the log line shows no host.
