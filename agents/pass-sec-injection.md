---
name: pass-sec-injection
description: Injection security pass — untrusted data read as code or query: SQL and NoSQL, OS command, server-side template, XSS, deserialization, eval, LDAP and XPath, header and log lines; one micro-rubric per sink, the framework's sanitizer located, every escape hatch named.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sec-common.md}}

# Lens: injection (data read as code or query)

Apply to: a diff that builds a query, command, template, markup, filter,
header or log line from a value; turns bytes into objects; evaluates or
dynamically loads anything; or changes the escaping, binding or parser
settings that protect such a sink. In a scan, the focus files that do the
same.

## Worksheet — fill it in your notes before writing any finding

1. **Sinks in scope.** Every interpreter the changed code hands a string or
   object to, with `file:line`.
2. **Where each argument comes from.** Trace it back to its source and give
   the trust label. Second order counts: a value stored earlier from
   untrusted input is still untrusted when it is read back — find the
   writer. A value the server chose, or a constant, is not a source.
3. **The sink's micro-rubric.** Answer the line for that sink:
   - **SQL:** bound parameters, or a string built by concatenation or
     formatting? Identifiers (a column, a table, a sort direction) cannot
     be bound, so they need an allowlist. ORM escape hatches (`raw()`,
     `extra`, literal SQL fragments) take nothing from input unbound.
   - **NoSQL:** can the body parser deliver an object where a string is
     expected, so an operator such as `$ne`, `$gt`, `$regex` or `$where`
     reaches the filter? Is a JavaScript-evaluating operator reachable?
   - **OS command:** an argument vector, or a string a shell parses
     (`shell=True`, `system`, backticks, `exec` of one string)? With an
     argument vector: can input starting with `-` become an option of
     `git`, `curl`, `tar` or `ssh` because nothing put `--` before it?
   - **Template:** is input used as the template source itself, rather
     than passed in as a value? Is the engine's sandbox turned off? Write
     any payload in words ("an expression in the engine's delimiters that
     reads the config object"), never with its brace syntax.
   - **XSS:** which context the value lands in — element body, quoted or
     unquoted attribute, URL (`javascript:` in an `href`), script block,
     JSON embedded in a page without escaping `</`. Is auto-escaping on for
     this template or component, and is an escape hatch used:
     `dangerouslySetInnerHTML`, `|safe`, `raw()`, `v-html`, `innerHTML`,
     `html_safe`? Stored XSS in an admin or support view counts.
   - **Deserialization:** native object formats (pickle, Java
     serialization, `Marshal`, `unserialize`), a YAML loader that builds
     arbitrary types, JSON with type names driving which class is built —
     on bytes an attacker can write, a cache or queue included.
   - **Eval and dynamic loading:** `eval`, `Function`, `exec`, an import or
     `require` path, or a class or method looked up by a name from input.
   - **LDAP, XPath:** a filter string assembled without the library's
     escaping.
   - **Header and log:** CR or LF reaching a response header, a redirect
     target or a line-oriented log where a forged entry matters (an audit
     trail).
4. **The sanitizer.** Name the framework's own protection and **where you
   checked it** (`file:line` of the binding call, the auto-escape setting,
   the argument array). A sanitizer for another context is none: HTML
   escaping in SQL, URL encoding in a shell string.
5. **Validation that forces a type** before the sink (an integer parse, an
   enum, a UUID check) defeats the finding; a length or character
   denylist rarely does — say which characters still pass.
6. **Hunt the defeating control** along the whole path, then write the
   input that survives it in `bypass:`.

## Evidence lines

Beside the base block:

    bypass:      <the input that reaches the sink intact, described in words where it needs braces>

Code or command execution, and a query that reads or writes other
principals' data, are impact **A**.

## Never a finding

- A query, command or template assembled only from constants and values
  the server chose.
- Bound parameters, an argument vector without a shell, or an
  auto-escaped context with no escape hatch, each checked at `file:line`.
- A `LIKE` wildcard, a regular expression's cost (denial of service), or a
  structured log field holding user text.
- Framework markup escaping assumed broken without a cited escape hatch or
  a URL or script context.

## Stay inside your lens

A path, URL, archive or XML parser is `pass-sec-boundaries`'s, XXE
included. Text reaching a model's context is `pass-sec-llm`'s. A token's
`kid` that reaches a query or a filter is yours; a `kid` that lets the
attacker pick the verifying key is `pass-sec-tokens`'s. A missing check on
which object the query may touch is `pass-sec-access`'s.
