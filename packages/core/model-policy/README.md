# @deepseek-ai/dsh-model-policy

English | [中文](README.zh.md)

Session-scoped Model Profiles and ordered Model Routes. A Profile is an authorization policy for concrete provider/model pairs and named Routes; a Route is an ordered fallback list of concrete provider/model pairs.

The service registers separate `model-profiles` and `model-routes` Settings sections. A Session stores a complete Profile snapshot in `model/profile`, so later settings edits cannot silently widen an existing Session. The built-in `unrestricted` Profile is used for legacy Sessions and permits every currently registered model and Route.

## Model Experience

### Profile and Route policy

#### What the model sees

The selected concrete model remains the normal model request.

##### Model request

```markdown
The normal Session history, system prompt, and tools are sent to the selected concrete model. Profile and Route control state is not added to the prompt.
```

#### Token effect

No additional prompt text is required.

##### Token accounting

```markdown
Profile and Route identifiers are control-plane state and do not enter the model-visible transcript.
```

#### KV Cache effect

Changing a Profile or target affects subsequent requests only.

##### Cache continuity

```markdown
Existing Session history and its stable prompt prefix are not rewritten.
```

## Known Limitations and Deferred Work

- Provider availability and adapter-specific model validation remain owned by the Host LLM consumer.
- The service defines durable authorization and route resolution; the Agent loop owns retry and categorized cross-model fallback execution.
