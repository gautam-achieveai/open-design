/** A local approval is an interaction aid, not proof that a human acted. */
export type McpApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

export interface McpApprovalScope {
  workspaceId: string;
  workspaceMemberId: string;
}

export interface McpApprovalView {
  id: string;
  principal: { kind: 'run' | 'external' | 'local'; id: string };
  projectId: string;
  scope: McpApprovalScope | null;
  tabId: string;
  operation: string;
  /** Origin and path only. Query and fragment are intentionally omitted. */
  location: string;
  /** Bounded, sanitized action description; not the full action. */
  preview: string;
  partial: boolean;
  createdAt: string;
  expiresAt: string;
  status: McpApprovalStatus;
  /** This action accepts only a main-owned native confirmation decision. */
  nativeConfirmationRequired?: boolean;
}

export interface BrowserPerformanceNativeChallenge {
  approvalId: string;
  projectId: string;
  tabId: string;
  location: string;
  expiresAt: string;
  reportId: string;
  cpu: number;
  bindingDigest: string;
}

export interface McpApprovalsResponse { approvals: McpApprovalView[] }
export interface McpApprovalResponse { approval: McpApprovalView }
