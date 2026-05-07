#!/usr/bin/env python3
"""Example: Using agent:<id> as a model replacement through Agent Bus Central."""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Add the SDK to the path when run from the repo root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from sdk.python.agent_bus_sdk import AgentBusClient, agent_model


def main() -> None:
    """Demonstrate agent:<id> model calls using the Python SDK."""
    
    # Configuration: use fake gateway for demo, or real gateway via environment
    gateway_url = os.environ.get("AGENT_BUS_GATEWAY_URL")
    token = os.environ.get("AGENT_BUS_TOKEN")
    
    if not gateway_url or not token:
        print("Starting fake gateway for demo...")
        gateway_url, token = start_fake_gateway()
    
    try:
        # Initialize the SDK client
        client = AgentBusClient(gateway_url=gateway_url, token=token)
        
        print(f"Connected to Agent Bus gateway at {gateway_url}")
        
        # Check gateway health
        health = client.health()
        print(f"Gateway health: {health}")
        
        # List available agents
        agents = client.agents()
        print(f"Available agents: {[agent['id'] for agent in agents]}")
        
        # List available models (should include agent:<id> entries)
        models = client.models()
        model_ids = [model['id'] for model in models.get('data', [])]
        print(f"Available models: {model_ids}")
        
        # Demonstrate agent:<id> model calls
        if agents:
            agent_id = agents[0]['id']
            print(f"\n=== Demonstrating agent:{agent_id} as model ===")
            
            # Method 1: Using agent_response() helper
            print("\n1. Using agent_response() helper:")
            response1 = client.agent_response(
                agent_id, 
                "Hello! Please introduce yourself and your capabilities.",
                temperature=0.7
            )
            print(f"Response: {response1.get('output_text', 'No output text')}")
            print(f"Agent bus metadata: {response1.get('agent_bus', {})}")
            
            # Method 2: Using response() with explicit agent:<id> model
            print("\n2. Using response() with explicit agent:<id> model:")
            response2 = client.response({
                "model": agent_model(agent_id),  # Converts to "agent:<id>"
                "input": "What can you help me with?",
                "temperature": 0.5
            })
            print(f"Response: {response2.get('output_text', 'No output text')}")
            print(f"Agent bus metadata: {response2.get('agent_bus', {})}")
            
            # Method 3: Using chat completion format
            print("\n3. Using chat completion format:")
            response3 = client.chat_completion({
                "model": agent_model(agent_id),
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Explain your role in Agent Bus."}
                ],
                "temperature": 0.3
            })
            print(f"Response: {response3.get('choices', [{}])[0].get('message', {}).get('content', 'No content')}")
            
            print(f"\n=== Demo completed successfully! ===")
        else:
            print("No agents available for demonstration.")
            
    except Exception as e:
        print(f"Error during demonstration: {e}")
        return 1
    
    return 0


def start_fake_gateway() -> tuple[str, str]:
    """Start a minimal fake gateway for demonstration purposes."""
    
    TOKEN = "demo-token"
    
    class DemoHandler(BaseHTTPRequestHandler):
        def _json(self, value, status=200):
            data = json.dumps(value).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        
        def _authorized(self):
            return self.headers.get("authorization") == f"Bearer {TOKEN}"
        
        def _body(self):
            length = int(self.headers.get("content-length") or 0)
            return json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        
        def do_GET(self):
            if self.path == "/health":
                return self._json({"ok": True, "nodes": 1, "agents": 2, "queued": 0})
            if not self._authorized():
                return self._json({"error": "unauthorized"}, 401)
            if self.path == "/agents":
                return self._json([
                    {"id": "demo-agent-1", "status": "online", "capabilities": ["chat", "response"]},
                    {"id": "demo-agent-2", "status": "online", "capabilities": ["chat", "response"]}
                ])
            if self.path == "/nodes":
                return self._json([
                    {"node_id": "demo-node", "status": "online", "agents": [
                        {"id": "demo-agent-1"}, {"id": "demo-agent-2"}
                    ]}
                ])
            if self.path == "/v1/models":
                return self._json({
                    "object": "list", 
                    "data": [
                        {"id": "agent:demo-agent-1", "object": "model"},
                        {"id": "agent:demo-agent-2", "object": "model"}
                    ]
                })
            return self._json({"error": "not_found"}, 404)
        
        def do_POST(self):
            if not self._authorized():
                return self._json({"error": "unauthorized"}, 401)
            
            body = self._body()
            model = body.get("model", "")
            input_text = body.get("input", "")
            
            if self.path == "/v1/responses":
                # Simulate agent response
                agent_id = model.replace("agent:", "") if model.startswith("agent:") else "unknown"
                response_text = f"Demo agent {agent_id} received: '{input_text}'. This is a simulated response."
                
                return self._json({
                    "id": f"resp_{agent_id}_{hash(input_text) % 10000}",
                    "output_text": response_text,
                    "agent_bus": {
                        "agent_id": agent_id,
                        "node_id": "demo-node",
                        "model": model,
                        "response_time_ms": 150
                    }
                })
            
            if self.path == "/v1/chat/completions":
                # Simulate chat completion
                agent_id = model.replace("agent:", "") if model.startswith("agent:") else "unknown"
                messages = body.get("messages", [])
                last_message = messages[-1].get("content", "") if messages else ""
                
                response_text = f"Demo agent {agent_id} responds to: '{last_message}'. This is a simulated chat completion."
                
                return self._json({
                    "id": f"chat_{agent_id}_{hash(last_message) % 10000}",
                    "object": "chat.completion",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": response_text
                        },
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 15, "total_tokens": 25},
                    "agent_bus": {
                        "agent_id": agent_id,
                        "node_id": "demo-node",
                        "model": model
                    }
                })
            
            return self._json({"error": "not_found"}, 404)
        
        def log_message(self, *_args):
            return  # Suppress server logs
    
    # Start server on random port
    server = ThreadingHTTPServer(("127.0.0.1", 0), DemoHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    
    gateway_url = f"http://127.0.0.1:{server.server_port}"
    print(f"Fake gateway started at {gateway_url}")
    
    return gateway_url, TOKEN


if __name__ == "__main__":
    sys.exit(main())
