FROM python:3.12-slim
WORKDIR /service
COPY services/analysis/ ./
RUN python -m pip install --no-cache-dir -r requirements.txt
EXPOSE 8001
CMD ["python", "main.py"]
