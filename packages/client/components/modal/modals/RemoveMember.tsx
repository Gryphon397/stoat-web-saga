import { useMutation } from "@tanstack/solid-query";

import { Avatar, Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Remove a member from a group
 */
export function RemoveMemberModal(
  props: DialogProps & Modals & { type: "remove_member" },
) {
  const { showError } = useModals();

  const removeMember = useMutation(() => ({
    mutationFn: () => props.group.removeMember(props.user.id),
    onError: showError,
  }));

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title="Remove Member"
      actions={[
        { text: "Cancel" },
        {
          text: "Remove",
          onClick: removeMember.mutateAsync,
        },
      ]}
      isDisabled={removeMember.isPending}
    >
      <Column align>
        <Avatar src={props.user.animatedAvatarURL} size={64} />
        <Text>
          Are you sure you want to remove{" "}
          {props.user.displayName ?? props.user.username} from{" "}
          {props.group.name}?
        </Text>
      </Column>
    </Dialog>
  );
}
