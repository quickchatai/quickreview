#!/usr/bin/env python3
"""Read-only PR context. Reject incomplete or mixed-head pagination."""
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import urllib.parse

MAX_PAGES = 100


def main():
    api, repo, number = sys.argv[1:]
    owner, name = repo.split("/", 1)
    ghread = os.environ.get("QCR_CONTEXT_GHREAD")
    token = None if ghread else os.environ["QCR_CONTEXT_TOKEN"]

    origin = urllib.parse.urlsplit(api)

    class ApiRedirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            target = urllib.parse.urlsplit(newurl)
            if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
                raise ValueError("refused cross-origin GitHub redirect")
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(ApiRedirects())

    def via_daemon(path, payload):
        # The daemon reads (src/ghread.ts): a REST GET by path, or this script's
        # GraphQL query by its name there ("pr-context"), the repo filled in by
        # the daemon. ghreadshim prints GitHub's status and writes the body.
        with tempfile.NamedTemporaryFile(prefix="pr-context-", delete=False) as fh:
            out = fh.name
        try:
            if payload is None:
                argv = ["node", ghread, "get", path, out]
            else:
                given = payload["variables"]
                variables = {k: given[k] for k in ("number", "filesCursor", "threadsCursor")}
                argv = ["node", ghread, "graphql", "pr-context", out, json.dumps(variables)]
            # the shim reads the command's capability from the inherited fd,
            # which Python closes in a child unless it is passed on by name
            cap_fd = int(os.environ["QCR_IPC_CAP_FD"])
            done = subprocess.run(
                argv, stdout=subprocess.PIPE, check=False, text=True, pass_fds=(cap_fd,)
            )
            if done.returncode != 0:
                raise ValueError("the daemon's read failed (" + path + ")")
            if done.stdout.strip() != "200":
                with open(out, encoding="utf-8", errors="replace") as fh:
                    raise ValueError(f"{path} -> {done.stdout.strip()}: {fh.read(300)}")
            with open(out, encoding="utf-8") as fh:
                return json.load(fh)
        finally:
            os.unlink(out)

    def request(path, payload=None):
        if ghread:
            return via_daemon(path, payload)
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(api + path, data=data, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        with opener.open(req, timeout=60) as response:
            return json.load(response)

    query = '''query($owner:String!,$name:String!,$number:Int!,$filesCursor:String,$threadsCursor:String){
      repository(owner:$owner,name:$name){pullRequest(number:$number){
        title state headRefOid baseRefName author{login}
        files(first:100,after:$filesCursor){nodes{path additions deletions} pageInfo{hasNextPage endCursor}}
        reviews(last:10){nodes{author{login} state submittedAt}}
        reviewThreads(first:100,after:$threadsCursor){nodes{id isResolved isOutdated path line
          comments(last:2){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}}
      }}}'''
    variables = {"owner": owner, "name": name, "number": int(number), "filesCursor": None, "threadsCursor": None}
    active = {"files": "filesCursor", "reviewThreads": "threadsCursor"}
    gathered = {key: [] for key in active}
    pr = None
    for _ in range(MAX_PAGES):
        envelope = request("/graphql", {"query": query, "variables": variables})
        if envelope.get("errors"):
            raise ValueError("GraphQL errors: " + json.dumps(envelope["errors"])[:300])
        page = envelope["data"]["repository"]["pullRequest"]
        if not page:
            raise ValueError("no such PR")
        if pr is None:
            pr = page
        elif page["headRefOid"] != pr["headRefOid"]:
            raise ValueError("PR head changed while reading context; retry")
        for connection, cursor_key in list(active.items()):
            value = page[connection]
            if not isinstance(value["nodes"], list):
                raise ValueError("unreadable " + connection + " nodes")
            gathered[connection].extend(value["nodes"])
            info = value["pageInfo"]
            if info["hasNextPage"] is False:
                del active[connection]
            elif info["hasNextPage"] is True:
                cursor = info.get("endCursor")
                if not isinstance(cursor, str) or not cursor or cursor == variables[cursor_key]:
                    raise ValueError("incomplete " + connection + ": missing or repeated cursor")
                variables[cursor_key] = cursor
            else:
                raise ValueError("incomplete " + connection + " page information")
        if not active:
            break
    else:
        raise ValueError("incomplete context: GraphQL page limit reached")

    def rest_pages(path, field):
        rows = []
        expected = None
        for page in range(1, MAX_PAGES + 1):
            result = request(path + f"?per_page=100&page={page}")
            count = result.get("total_count")
            if count is not None:
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    raise ValueError("unreadable " + field + " total_count")
                if expected is not None and count != expected:
                    raise ValueError("incomplete " + field + ": count changed while reading")
                expected = count
            batch = result[field]
            if not isinstance(batch, list):
                raise ValueError("unreadable " + field)
            rows.extend(batch)
            if len(batch) < 100:
                if expected is not None and len(rows) != expected:
                    raise ValueError("incomplete " + field + ": advertised count not reached")
                return rows
        raise ValueError("incomplete context: " + field + " page limit reached")

    sha = pr["headRefOid"]
    checks = rest_pages(f"/repos/{repo}/commits/{sha}/check-runs", "check_runs")
    statuses = rest_pages(f"/repos/{repo}/commits/{sha}/status", "statuses")
    who = lambda value: (value or {}).get("login", "?")
    print(f"== META #{number} ==")
    print(f"title: {pr['title']}")
    print(f"author: {who(pr['author'])}  state: {pr['state']}")
    print(f"head: {sha}  base: {pr['baseRefName']}")
    print("\n== FILES ==")
    for item in gathered["files"]:
        print(f"+{item['additions']} -{item['deletions']}  {item['path']}")
    print("\n== CHECKS ==")
    for item in checks:
        print(f"{item['name']}: {item['status']}/{item.get('conclusion') or '-'}")
    for item in statuses:
        print(f"status {item.get('context') or 'status'}: {item.get('state') or '-'}")
    print("\n== REVIEWS (latest) ==")
    for item in pr["reviews"]["nodes"]:
        print(f"{who(item['author'])}: {item['state']}  {item.get('submittedAt') or '-'}")
    print("\n== THREADS (unresolved) ==")
    for item in gathered["reviewThreads"]:
        if item["isResolved"]:
            continue
        loc = f"{item.get('path') or '?'}:{item.get('line') or '?'}"
        print(f"-- {item['id']}  outdated={str(item['isOutdated']).lower()}  {loc}")
        for comment in item["comments"]["nodes"]:
            body = " ".join((comment.get("body") or "").split())[:400]
            print(f"   {who(comment['author'])}: {body}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError) as error:
        print("pr-context: " + str(error), file=sys.stderr)
        sys.exit(1)
