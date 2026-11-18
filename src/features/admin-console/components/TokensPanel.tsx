"use client";

import { useState, type ChangeEvent } from "react";
import { Alert, Button, Card, Col, Input, Modal, Popconfirm, Row, Select, Space, Tag } from "antd";
import type { TableProps } from "antd";
import type { AppScopeRow, TokenRow } from "../types";
import { AdminTable } from "./AdminTable";
import { sortDate, sortStr } from "../lib/adminColumnHelpers";
import { resolveTokenAppScopeIds } from "../lib/tokenAppScopeDisplay";

type TokenForm = { label: string; personName: string; personCode: string; expiresInDays: string; appScopeIds: string[] };

type Props = {
  creatingToken: boolean;
  tokenForm: TokenForm;
  tokenOnce: string;
  tokens: TokenRow[];
  appScopes: AppScopeRow[];
  onTokenFormChange: (fn: (prev: TokenForm) => TokenForm) => void;
  onCreate: () => void;
  onPatch: (id: string, revoked: boolean) => void;
  onRecreate: (id: string) => void;
  onUpdateScopes: (id: string, appScopeIds: string[]) => void;
  onViewRequests: (tokenId: string) => void;
};

export function TokensPanel(props: Props) {
  const [editingScopes, setEditingScopes] = useState<{ id: string; appScopeIds: string[] } | null>(null);
  const scopeLabelMap = new Map(props.appScopes.map((x) => [x.id, x.label]));
  const allScopeIds = props.appScopes.map((x) => x.id);
  const normalizeScopeIds = (ids: string[] | undefined) => resolveTokenAppScopeIds(ids, allScopeIds);
  const renderAppScopeTags = (ids: string[] | undefined) => {
    const scopeIds = normalizeScopeIds(ids);
    if (!scopeIds.length) {
      return <Tag color="default">全部应用（未单独配置）</Tag>;
    }
    return scopeIds.map((id) => <Tag key={id}>{scopeLabelMap.get(id) || id}</Tag>);
  };

  const columns: TableProps<TokenRow>["columns"] = [
    { ...sortStr<TokenRow>("personName", "姓名") },
    { ...sortStr<TokenRow>("personCode", "工号") },
    {
      title: "应用权限",
      render: (_, row) => (
        <Space wrap size={4}>
          {renderAppScopeTags(row.appScopeIds)}
        </Space>
      ),
    },
    {
      title: "状态",
      sorter: (a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt),
      render: (_, row) => (row.revokedAt ? <Tag color="error">已吊销</Tag> : <Tag color="success">可用</Tag>),
    },
    {
      ...sortDate<TokenRow>((row) => row.expiresAt, "过期时间"),
      render: (_, row) => (row.expiresAt ? new Date(row.expiresAt).toLocaleString() : "-"),
    },
    {
      ...sortDate<TokenRow>((row) => row.createdAt, "创建时间"),
      render: (_, row) => new Date(row.createdAt).toLocaleString(),
    },
    {
      title: "操作",
      render: (_, row) => (
        <Space wrap>
          {row.revokedAt ? (
            <Button size="small" onClick={() => props.onPatch(row.id, false)}>
              恢复
            </Button>
          ) : (
            <Button size="small" danger onClick={() => props.onPatch(row.id, true)}>
              吊销
            </Button>
          )}
          <Button size="small" onClick={() => props.onViewRequests(row.id)}>
            AI问答记录
          </Button>
          <Popconfirm
            title="重新创建 Token"
            description="会生成新 Token 并吊销当前 Token，确认继续？"
            okText="确认"
            cancelText="取消"
            onConfirm={() => props.onRecreate(row.id)}
          >
            <Button size="small">重新创建</Button>
          </Popconfirm>
          <Button
            size="small"
            onClick={() =>
              setEditingScopes({
                id: row.id,
                appScopeIds: normalizeScopeIds(row.appScopeIds),
              })
            }
          >
            编辑权限
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Card className="admin-card" title="创建 Token">
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <Input placeholder="姓名" value={props.tokenForm.personName} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onTokenFormChange((x) => ({ ...x, personName: e.target.value }))} />
          </Col>
          <Col xs={24} md={12}>
            <Input placeholder="工号" value={props.tokenForm.personCode} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onTokenFormChange((x) => ({ ...x, personCode: e.target.value }))} />
          </Col>
          <Col xs={24} md={12}>
            <Input placeholder="备注 label（可选）" value={props.tokenForm.label} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onTokenFormChange((x) => ({ ...x, label: e.target.value }))} />
          </Col>
          <Col xs={24} md={12}>
            <Input placeholder="过期天数（可选）" value={props.tokenForm.expiresInDays} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onTokenFormChange((x) => ({ ...x, expiresInDays: e.target.value }))} />
          </Col>
          <Col span={24}>
            <Select
              mode="multiple"
              style={{ width: "100%" }}
              value={props.tokenForm.appScopeIds}
              options={props.appScopes.map((x) => ({ value: x.id, label: x.label }))}
              placeholder="留空表示可访问全部应用；选择后仅可访问所选应用"
              onChange={(value) => props.onTokenFormChange((x) => ({ ...x, appScopeIds: value }))}
            />
          </Col>
          <Col span={24}>
            <Alert type="info" showIcon message="未选择任何应用时，Token 默认可访问全部应用；仅在选择应用后才会限制权限。" />
          </Col>
          <Col span={24}>
            <Button type="primary" loading={props.creatingToken} onClick={props.onCreate}>
              创建 Token
            </Button>
          </Col>
        </Row>
        {props.tokenOnce ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message="仅展示一次，请立即保存" description={<pre style={{ margin: 0 }}>{props.tokenOnce}</pre>} /> : null}
      </Card>
      <Card className="admin-card" title="Token 列表">
        <AdminTable<TokenRow> tableKey="tokens" rowKey="id" columns={columns} dataSource={props.tokens} />
      </Card>
      <Modal
        title="编辑 Token 应用权限"
        open={!!editingScopes}
        onCancel={() => setEditingScopes(null)}
        onOk={() => {
          if (!editingScopes) return;
          props.onUpdateScopes(editingScopes.id, editingScopes.appScopeIds);
          setEditingScopes(null);
        }}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Alert type="info" showIcon message="清空全部选项表示可访问全部应用；选择后仅可访问所选应用。" />
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            value={editingScopes?.appScopeIds || []}
            options={props.appScopes.map((x) => ({ value: x.id, label: x.label }))}
            placeholder="留空表示可访问全部应用"
            onChange={(value) => setEditingScopes((prev) => (prev ? { ...prev, appScopeIds: value } : prev))}
          />
        </Space>
      </Modal>
    </Space>
  );
}

