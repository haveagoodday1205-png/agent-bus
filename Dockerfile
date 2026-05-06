FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY agent-bus.mjs central-gateway.mjs edge-node.mjs mock-openai-backend.mjs windows-openai-proxy.mjs ./
COPY console ./console
COPY docs ./docs
COPY central.config.example.json edge.config.example.json edge.120.example.json edge.178.example.json edge.hk.example.json ./

ENV AGENT_BUS_HOST=0.0.0.0
ENV AGENT_BUS_PORT=8788

EXPOSE 8788

ENTRYPOINT ["node", "/app/agent-bus.mjs"]
CMD ["serve", "--config", "/config/central.config.json"]
