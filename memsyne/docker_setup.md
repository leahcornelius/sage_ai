docker run -d -p 6333:6333 qdrant/qdrant

docker run -d --name ollama -p 11434:11434 -v ollama_data:/root/.ollama ollama/ollama
docker exec ollama ollama pull nomic-embed-text

docker run -d --name falkordb -p 6380:6379 -v falkordb_data:/data falkordb/falkordb

docker run -d --name redis -p 6379:6379 -v redis_data:/data redis:7-alpine redis-server --appendonly yes