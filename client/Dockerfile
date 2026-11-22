# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY shared/package.json ./shared/

# Install dependencies
RUN npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps
RUN cd shared && npm install --legacy-peer-deps

# Copy source code
COPY shared ./shared
COPY client ./client
COPY tsconfig.json ./

# Build shared and client
RUN cd shared && npm run build
# Empty by default: the app then calls the API at its own address, and the
# nginx below forwards /api and /ws to the server. Set both only when the API
# has its own public address.
ARG VITE_API_URL=
ARG VITE_WS_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN cd client && npm run build

# Production stage
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/client/dist /usr/share/nginx/html

# nginx configuration. The image renders templates/*.template into conf.d at
# start, filling in API_UPSTREAM: where /api and /ws are forwarded.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY client/nginx.conf /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=server:3001
ENV NGINX_ENVSUBST_FILTER=^API_UPSTREAM$

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
