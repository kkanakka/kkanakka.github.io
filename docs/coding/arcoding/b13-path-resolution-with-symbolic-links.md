---
title: "B13 · Path resolution with symbolic links"
slug: /coding/arcoding/b13-path-resolution-with-symbolic-links
sidebar_position: 20
sidebar_label: "B13 · Path resolution with symbolic links"
description: "B13 · Path resolution with symbolic links"
---

<div class="arcoding">

## B13 · Path resolution with symbolic links

<p class="covers">Covers: Path Resolution with Symbolic Links, and the traversal core of "Implement a hierarchical file store".</p>

### The approach

<img src="/diagrams/arcoding/b13.svg" alt="Path components are walked one at a time against a resolved-path stack; an absolute symlink target restarts from the root, a relative one replaces the link component, and a hop counter raises ELOOP." class="doc-diagram doc-diagram-seq" />

<p>Resolution is <strong>component-by-component</strong>, not a single string rewrite, because a symlink anywhere in the middle changes the meaning of everything after it. An absolute target clears the resolved path and restarts at the root; a relative one replaces just the link component. <code>..</code> applies to the <em>resolved</em> path, not the literal one — that is the detail that separates this from plain string simplification. The hop counter is what catches cycles: a visited-set misses growing traps like <code>a → a/b</code>, while a hop cap catches both.</p>

### What it looks like in memory

<p>One resolution walked step by step — the <code>/data/current/model.bin</code> case from <em>Run it</em>.</p>

<img src="/diagrams/arcoding-state/b13.svg" alt="A symlink resolution walked step by step, showing the resolved path and the pending stack at each stage." class="doc-diagram doc-diagram-seq" />

<h4>Full version — component-wise symlink resolution with loop detection</h4>
<p>The key insight: you cannot textually simplify first and then substitute links. A symlink can appear <em>mid-path</em>, its target can be relative, contain <code>..</code>, or contain further links — so resolution must proceed one component at a time against the <em>resolved-so-far</em> prefix.</p>

<p>Worked trace (narrate one like this in the interview): <code>links = {"/a/b": "/x", "/x/c": "../y"}</code>, resolve <code>"/a/b/c/d"</code> → consume <code>a</code>,<code>b</code> → <code>/a/b</code> is a link → restart with <code>x</code>, pending <code>c,d</code> → consume <code>c</code> → <code>/x/c</code> is a link to <code>../y</code> → pop <code>c</code>, push <code>..</code>,<code>y</code> → <code>..</code> pops <code>x</code> → consume <code>y</code>,<code>d</code> → <strong><code>/y/d</code></strong>.</p>

<p class="covers">The complete program — save it as <code>b13_resolve_path.py</code> and run <code>python b13_resolve_path.py</code>.</p>

```python
def simplify(path: str) -> str:
    """/a/./b/../c -> /a/c   — the LC-71 core everyone should nail fast.

    Example:
        >>> simplify('/a/./b/../c')
        '/a/c'
        >>> simplify('/../')
        '/'
    """
    out = []
    for comp in path.split("/"):
        if comp in ("", "."):
            continue
        if comp == "..":
            if out:
                out.pop()          # at root, .. is a no-op (POSIX)
        else:
            out.append(comp)
    return "/" + "/".join(out)

class SymlinkLoopError(RuntimeError):
    pass


def resolve(path: str, links: dict[str, str], *, max_hops: int = 64) -> str:
    """links: absolute resolved path -> target (absolute or relative).
    Kernel-style behavior: component-wise walk; ELOOP-equivalent after
    max_hops link traversals (a hop cap catches both direct cycles and
    growing 'a -> a/b' style traps that a visited-set can miss).

    Example:
        >>> links = {'/bin': '/usr/bin', '/usr/bin/py': 'python3'}
        >>> resolve('/bin/py', links)
        '/usr/bin/python3'
    """
    pending = [c for c in path.split("/") if c][::-1]   # reversed work stack
    out: list[str] = []
    hops = 0

    while pending:
        comp = pending.pop()
        if comp == ".":
            continue
        if comp == "..":
            if out:
                out.pop()          # applies to the RESOLVED path
            continue
        out.append(comp)
        cur = "/" + "/".join(out)
        target = links.get(cur)
        if target is not None:
            hops += 1
            if hops > max_hops:
                raise SymlinkLoopError(f"too many symlinks resolving {path!r}")
            if target.startswith("/"):
                out.clear()        # absolute target: restart from root
            else:
                out.pop()          # relative: replace the link component
            pending.extend([c for c in target.split("/") if c][::-1])

    return "/" + "/".join(out)


if __name__ == "__main__":
    print("--- simplify (no links) ---")
    for p in ("/a/./b/../c", "/../", "/home//foo/", "/a/b/c/../../.."):
        print(f"{p:<18} -> {simplify(p)}")

    links = {
        "/bin":          "/usr/bin",        # absolute target: restart at root
        "/usr/bin/py":   "python3.13",      # relative target: sibling
        "/data/current": "../releases/v7",  # relative with ..
    }

    print("\n--- resolve (with symlinks) ---")
    for p in ("/bin/py", "/data/current/model.bin", "/usr/bin/../lib"):
        print(f"{p:<26} -> {resolve(p, links)}")

    print("\n--- ELOOP: a cycle is caught, not hung ---")
    cyclic = {"/a": "/b", "/b": "/a"}
    try:
        resolve("/a", cyclic, max_hops=8)
    except SymlinkLoopError as e:
        print("SymlinkLoopError:", e)
```

<p><strong>Output</strong></p>

```text
--- simplify (no links) ---
/a/./b/../c        -> /a/c
/../               -> /
/home//foo/        -> /home/foo
/a/b/c/../../..    -> /

--- resolve (with symlinks) ---
/bin/py                    -> /usr/bin/python3.13
/data/current/model.bin    -> /releases/v7/model.bin
/usr/bin/../lib            -> /usr/lib

--- ELOOP: a cycle is caught, not hung ---
SymlinkLoopError: too many symlinks resolving '/a'
```

<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Why component-wise:</strong> give the counterexample — with <code>/a/b → /x</code>, the path <code>/a/b/../c</code> is <code>/x/../c = /c</code>, but textual simplification first gives <code>/a/c</code>. This single example justifies the whole design.</li>
<li><strong>Loop defense:</strong> a hop cap is what kernels use (ELOOP at ~40); a visited-set of link paths also works for pure cycles but the cap is simpler and covers more. Know both.</li>
<li><strong>.. above root</strong> is a no-op, not an error (POSIX). State it.</li>
<li><strong>Hierarchical file store variant:</strong> same walk, but each component is looked up in a node tree (dirs as dicts) — resolution and storage compose cleanly if the resolver is its own function.</li>
</ul></div>

<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(components processed), where the hop cap bounds expansion: at most <code>max_hops</code> link substitutions, each injecting O(len(target)) components — so worst case O(|path| + max_hops &times; max_target_len), i.e., effectively linear with a safety ceiling. <strong>Space:</strong> O(resolved path + pending components).</p><p><strong>How efficient is it?</strong> Linear is optimal (every component must be looked at), and the hop cap is what keeps the worst case <em>defined</em> at all — without it, self-referential links make resolution non-terminating. Dict lookups make each link check O(1); the interesting cost is semantic, not asymptotic: resolving against the resolved-so-far prefix is what buys correctness for mid-path links, at zero extra complexity.</p></div>

</div>
