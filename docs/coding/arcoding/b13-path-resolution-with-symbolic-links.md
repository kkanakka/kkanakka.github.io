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
<h4>Warm-up (do this first): simplify a path — no links</h4>

```
def simplify(path: str) -> str:
    """/a/./b/../c -> /a/c   — the LC-71 core everyone should nail fast."""
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
```

<h4>Full version — component-wise symlink resolution with loop detection</h4>
<p>The key insight: you cannot textually simplify first and then substitute links. A symlink can appear <em>mid-path</em>, its target can be relative, contain <code>..</code>, or contain further links — so resolution must proceed one component at a time against the <em>resolved-so-far</em> prefix.</p>

```
class SymlinkLoopError(RuntimeError):
    pass


def resolve(path: str, links: dict[str, str], *, max_hops: int = 64) -> str:
    """links: absolute resolved path -> target (absolute or relative).
    Kernel-style behavior: component-wise walk; ELOOP-equivalent after
    max_hops link traversals (a hop cap catches both direct cycles and
    growing 'a -> a/b' style traps that a visited-set can miss)."""
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
```

<p>Worked trace (narrate one like this in the interview): <code>links = {"/a/b": "/x", "/x/c": "../y"}</code>, resolve <code>"/a/b/c/d"</code> → consume <code>a</code>,<code>b</code> → <code>/a/b</code> is a link → restart with <code>x</code>, pending <code>c,d</code> → consume <code>c</code> → <code>/x/c</code> is a link to <code>../y</code> → pop <code>c</code>, push <code>..</code>,<code>y</code> → <code>..</code> pops <code>x</code> → consume <code>y</code>,<code>d</code> → <strong><code>/y/d</code></strong>.</p>
<div class="adm tip"><div class="adm-title">💡 What they probe</div>
<ul>
<li><strong>Why component-wise:</strong> give the counterexample — with <code>/a/b → /x</code>, the path <code>/a/b/../c</code> is <code>/x/../c = /c</code>, but textual simplification first gives <code>/a/c</code>. This single example justifies the whole design.</li>
<li><strong>Loop defense:</strong> a hop cap is what kernels use (ELOOP at ~40); a visited-set of link paths also works for pure cycles but the cap is simpler and covers more. Know both.</li>
<li><strong>.. above root</strong> is a no-op, not an error (POSIX). State it.</li>
<li><strong>Hierarchical file store variant:</strong> same walk, but each component is looked up in a node tree (dirs as dicts) — resolution and storage compose cleanly if the resolver is its own function.</li>
</ul></div>
<div class="adm info"><div class="adm-title">⏱️ Complexity &amp; efficiency</div><p><strong>Time:</strong> O(components processed), where the hop cap bounds expansion: at most <code>max_hops</code> link substitutions, each injecting O(len(target)) components — so worst case O(|path| + max_hops &times; max_target_len), i.e., effectively linear with a safety ceiling. <strong>Space:</strong> O(resolved path + pending components).</p><p><strong>How efficient is it?</strong> Linear is optimal (every component must be looked at), and the hop cap is what keeps the worst case <em>defined</em> at all — without it, self-referential links make resolution non-terminating. Dict lookups make each link check O(1); the interesting cost is semantic, not asymptotic: resolving against the resolved-so-far prefix is what buys correctness for mid-path links, at zero extra complexity.</p></div>

</div>
