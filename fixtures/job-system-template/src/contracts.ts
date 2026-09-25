export interface JobRequest {
  id: string
  value: string
}

export interface JobAccepted {
  id: string
  status: 'accepted'
}

export interface JobRecord {
  id: string
  status: 'pending' | 'completed'
  result?: string
}

export interface JobEvent {
  eventId: string
  jobId: string
  value: string
}
