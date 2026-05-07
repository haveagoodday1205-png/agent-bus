# Python Agent Model Example

This example demonstrates how to use the Agent Bus Python SDK to call agents as model replacements through the `/v1/responses` endpoint with `model: agent:<id>`.

## Overview

The example shows three different ways to make agent calls:

1. **Using `agent_response()` helper** - The simplest method
2. **Using `response()` with explicit agent:<id> model** - Direct API access
3. **Using `chat_completion()` format** - OpenAI-compatible interface

## Running the Example

### With a Fake Gateway (No Setup Required)

The example includes a built-in fake gateway for demonstration:

```bash
python examples/python-agent-model/agent_model_example.py
```

This will start a minimal HTTP server that simulates Agent Bus responses and demonstrate all three calling patterns.

### With a Real Agent Bus Gateway

To use a real Agent Bus gateway, set the environment variables:

```bash
export AGENT_BUS_GATEWAY_URL="https://your-domain.com/agent-bus"
export AGENT_BUS_TOKEN="your-token"
python examples/python-agent-model/agent_model_example.py
```

## Code Structure

The example demonstrates:

- **Gateway Connection**: Initializing the `AgentBusClient`
- **Agent Discovery**: Listing available agents and models
- **Model Calls**: Three different patterns for calling agents as models
- **Response Handling**: Processing agent responses and metadata

### Key Patterns

```python
from sdk.python.agent_bus_sdk import AgentBusClient, agent_model

# Initialize client
client = AgentBusClient(gateway_url=gateway_url, token=token)

# Method 1: Helper function
response = client.agent_response("agent-id", "Your input here")

# Method 2: Direct response call
response = client.response({
    "model": agent_model("agent-id"),  # Converts to "agent:agent-id"
    "input": "Your input here"
})

# Method 3: Chat completion format
response = client.chat_completion({
    "model": agent_model("agent-id"),
    "messages": [{"role": "user", "content": "Your message here"}]
})
```

## Replacing the Fake Gateway

To use this example with a real Agent Bus deployment:

1. **Set up Agent Bus Central** following the main repository instructions
2. **Configure edge nodes** with your desired agents
3. **Set environment variables**:
   - `AGENT_BUS_GATEWAY_URL`: URL to your Central gateway
   - `AGENT_BUS_TOKEN`: Authentication token for the gateway
4. **Run the example** without any code changes

The example automatically detects whether to use the fake gateway or real gateway based on these environment variables.

## Requirements

- Python 3.10+
- No external dependencies (uses only Python standard library)
- Agent Bus Python SDK (included in the repository)

## Validation

The example can be validated with:

```bash
# Compile check
python -m py_compile examples/python-agent-model/agent_model_example.py

# Run with SDK smoke test
npm run sdk:python:smoke -- --json
```

## Use Cases

This pattern is useful for:

- **Model Replacement**: Using agents instead of traditional AI models
- **Agent Orchestration**: Having agents call other agents
- **Hybrid Workflows**: Combining traditional models with agent capabilities
- **Testing**: Validating agent behavior without live model calls
