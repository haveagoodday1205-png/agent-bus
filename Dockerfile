FROM node:22-alpine

RUN apk add --no-cache python3

WORKDIR /app

COPY package.json ./
COPY agent-bus.mjs central-gateway.mjs central_gateway.py edge-node.mjs edge_node.py mock-openai-backend.mjs windows-openai-proxy.mjs ./
COPY console ./console
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts
COPY sdk ./sdk
COPY central.config.example.json edge.config.example.json edge.120.example.json edge.178.example.json edge.hk.example.json ./

ENV AGENT_BUS_HOST=0.0.0.0
ENV AGENT_BUS_PORT=8788
ENV AGENT_BUS_CONFIG=/config/central.config.json
ENV AGENT_BUS_CENTRAL_RUNTIME=python

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "const port=process.env.AGENT_BUS_PORT||8788; fetch('http://127.0.0.1:'+port+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/agent-bus.mjs"]
CMD ["serve", "--runtime", "python", "--config", "/config/central.config.json"]
