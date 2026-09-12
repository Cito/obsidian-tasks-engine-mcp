---
tags: [project, important]
status: active
---

# Pitfalls

The following sits in a code block and is **not** a task:

```markdown
- [ ] Task in a code block
- [ ] Another one in a code block
```

And this one in a tilde-fenced block:

~~~text
- [ ] Task in a tilde block
~~~

This one, however, is a real task: 

- [ ] Real task next to the fences #inline
- [-] Cancelled task
