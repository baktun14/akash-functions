# Akash Functions runner — single image deployed for every function.
# At container boot, fetches user source from CODE_URL using CODE_TOKEN, then
# spawns `bun src/index.ts`. SDL injects FUNCTION_ID, VERSION_ID, CODE_URL,
# CODE_TOKEN, PORT, and (optionally) AKASHML_API_KEY.

FROM oven/bun:1.3-alpine

# Tar is needed to extract the source bundle the backend serves.
RUN apk add --no-cache tar

WORKDIR /app
COPY boot.ts /boot/boot.ts

ENV PORT=3000
EXPOSE 3000

# Boot script handles fetch → install → spawn user code.
CMD ["bun", "/boot/boot.ts"]
