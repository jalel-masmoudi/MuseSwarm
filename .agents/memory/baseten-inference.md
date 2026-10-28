# Baseten Muse Spark Open Inference Notes

- **Endpoint:** `https://inference.baseten.co/v1/chat/completions`
- **Model ID:** `meta-models/muse-spark-open-1026`
- **Reasoning Tokens:** `meta-models/muse-spark-open-1026` emits internal chain-of-thought in `choices[0].message.reasoning_content` before emitting `choices[0].message.content`. Always set `max_tokens >= 1500` on complex tasks so reasoning completes before final JSON/code generation.
