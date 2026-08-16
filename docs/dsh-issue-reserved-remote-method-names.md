# GitHub Issue 文案（deepseek-ai/deepseek-harness）

提交地址：https://github.com/deepseek-ai/deepseek-harness/issues/new

---

## Title

```
docs: reserved remote method names on the client namespace service are undocumented (e.g. `remove`)
```

## Body

### Summary

`ctx.remote` (the Typert client gateway) silently reserves a large set of method
names per namespace. Installing a remote method whose name collides throws

```
client api: method "requirements/remove" conflicts with its namespace service
```

but the reserved names are **not documented anywhere**, and the error message
does not tell the developer which names are reserved or why.

### Where

`packages/api/gateway/src/client/index.ts` — `RemoteNamespaceService.assertMethodAvailable`:

```ts
if (REMOTE_NAMESPACE_FIELDS.has(method) || method in RemoteNamespaceService.prototype) {
  throw new Error(`client api: method ${JSON.stringify(`${namespace}/${method}`)} conflicts with its namespace service`)
}
```

### What is actually reserved (all undocumented)

1. An explicit set: `ctx`, `empty`, `invokeRemote`, `methods`, `name`, `namespace`
   (`REMOTE_NAMESPACE_FIELDS`).
2. **Implicitly, every name found on the prototype chain** of
   `RemoteNamespaceService`, because the check uses `method in ...prototype`:
   - the service's own members: `assertMethodAvailable`, `has`, `installDirect`,
     `installScoped`, `remove`;
   - members inherited from the cordis `Service`/`Base` chain;
   - even `Object.prototype` members (`constructor`, `toString`,
     `hasOwnProperty`, ...).

So a plugin that mounts a very ordinary CRUD method named `remove` (or `has`,
`on`, `toString`, ...) fails at `$mount` with a confusing error, and the only
workaround is trial-and-error renaming.

### Repro

- A client plugin calls `ctx.remote.$mount` with a descriptor
  `{ namespace: 'requirements', method: 'remove', ... }`.
- `$mount` rejects with
  `client api: method "requirements/remove" conflicts with its namespace service`.
- No documentation or API exposes the reserved set, so there is no way to
  discover this without reading the source.

### Suggested fix (any combination of)

1. **Document the reserved names** — minimal ask: add a "reserved keywords"
   section to `docs/subsystems/typert.md` (and the plugin guide). Reserved
   keywords are perfectly reasonable as long as they are documented.
2. Better: narrow the check to **own** members only —
   `Object.hasOwn(RemoteNamespaceService.prototype, method)` — so inherited
   base-class names and `Object.prototype` names stop leaking into the plugin
   namespace; keep the explicit `REMOTE_NAMESPACE_FIELDS` plus own members as
   the reserved set.
3. Export the reserved set programmatically (e.g. a
   `RESERVED_REMOTE_NAMESPACE_METHODS` constant) so plugins can pre-validate
   and surface a clear error before `$mount`.

### Note on stability

The current check also makes the reserved set **unstable across releases**:
any new method added to the base class silently becomes reserved, which can
break existing plugins on upgrade without any source change on the plugin side.

---

**Environment**: dsh 0.1.0-rc.5, commit `47f943859b`
