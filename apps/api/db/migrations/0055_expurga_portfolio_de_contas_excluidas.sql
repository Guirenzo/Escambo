-- Remove os itens que ficaram ligados a contas anonimizadas antes da correção.
-- O expurgo de mídia remove as imagens locais sem nenhuma referência restante.
DELETE i FROM freelancer_portfolio_items i
  JOIN profiles_freelancer pf ON pf.id = i.freelancer_id
  JOIN users u ON u.id = pf.user_id
 WHERE u.deleted_at IS NOT NULL;
