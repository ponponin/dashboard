# Use official Node.js 22 LTS image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy all source files
COPY . .

# Build the Vite frontend static files
RUN npm run build

# Expose port 3000 (Railway will map PORT automatically)
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Start the Express server
CMD ["npm", "start"]
