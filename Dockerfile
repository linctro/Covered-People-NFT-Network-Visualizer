# Build Stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Copy go mod file
COPY go.mod ./
# If you have go.sum, uncomment the next line
# COPY go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application
# Assumes main entry point is at cmd/server/main.go
RUN go build -o server ./cmd/server/main.go

# Production Stage
FROM alpine:latest

WORKDIR /root/

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates

# Copy the binary from builder
COPY --from=builder /app/server .

# Copy static files
COPY --from=builder /app/static ./static

# Expose port (Cloud Run sets PORT env var, but 8080 is default fallback)
EXPOSE 8080

# Run the binary
CMD ["./server"]
